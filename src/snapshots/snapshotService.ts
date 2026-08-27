import { App, Notice } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext } from "../observability/traceContext";
import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
import type { ProductFlightEventInput } from "../observability/traceSink";
import type { AttachmentCatalogPort, BlobSyncManager } from "../sync/blobSync";
import type { VaultSync } from "../sync/vaultSync";
import { ConfirmModal } from "../ui/ConfirmModal";
import { formatUnknown } from "../utils/format";
import { RecoveryBackupHook } from "./recoveryBackup";
import {
	RecoveryClient,
	RecoveryTerminalItemError,
	type RecoveryLiveFile,
	type RecoveryRuntimePort,
	type RecoverySnapshotSummary,
	type RestoreItem,
	type RestoreItemResult,
	type RestoreSelection,
	isRecoveryTerminal,
} from "./recoveryClient";
import {
	RecoveryBrowseModal,
	RecoveryCaptureStatusModal,
	RecoverySnapshotListModal,
} from "./recoveryModals";
import type { PendingRecoveryState } from "./recoveryState";

interface SnapshotServiceDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getVaultSync(): VaultSync | null;
	getRecoveryRuntime(): RecoveryRuntimePort | null;
	getAttachmentCatalog(): AttachmentCatalogPort | null;
	getBlobSync(): BlobSyncManager | null;
	getPendingRecoveryState(): PendingRecoveryState;
	persistPendingRecoveryState(state: PendingRecoveryState): Promise<void>;
	getServerSupportsSnapshots(): boolean;
	log(message: string): void;
	onEditorsNeedReconcile(reason: string): void;
	recordFlightEvent?(event: ProductFlightEventInput): void;
}

const STATUS_POLL_MS = 5_000;
const RESTORE_PAGE_SIZE = 50;

export class SnapshotService {
	private monitorTimer: number | null = null;
	private monitoring = false;
	private captureStatusModal: RecoveryCaptureStatusModal | null = null;
	private snapshotListModal: RecoverySnapshotListModal | null = null;
	private browseModal: RecoveryBrowseModal | null = null;

	constructor(private readonly deps: SnapshotServiceDeps) {}

	resumePersistedOperations(): void {
		const pending = this.deps.getPendingRecoveryState();
		if (pending.activeCaptureId || pending.activeRestore) this.scheduleMonitor(0);
	}

	destroy(): void {
		if (this.monitorTimer !== null) window.clearTimeout(this.monitorTimer);
		this.monitorTimer = null;
		this.captureStatusModal?.close();
		this.captureStatusModal = null;
		this.snapshotListModal?.close();
		this.snapshotListModal = null;
		this.browseModal?.close();
		this.browseModal = null;
	}

	getDiagnostics(): PendingRecoveryState {
		return this.deps.getPendingRecoveryState();
	}

	async triggerDailySnapshot(): Promise<void> {
		if (!this.deps.getServerSupportsSnapshots() || !this.deps.getVaultSync()?.connected) return;
		const pending = this.deps.getPendingRecoveryState();
		if (pending.activeCaptureId) return;
		try {
			const started = await this.client().startCapture("daily", crypto.randomUUID());
			await this.persist({ activeCaptureId: started.captureId, lastCaptureStatus: null });
			this.deps.log(`Daily recovery capture queued at sequence ${started.boundarySequence}: ${started.captureId}`);
			this.scheduleMonitor(0);
		} catch (error) {
			this.deps.log(`Daily recovery capture admission failed: ${formatUnknown(error)}`);
		}
	}

	async takeSnapshotNow(): Promise<void> {
		if (!this.canUseRecovery("capture a recovery point")) return;
		const pending = this.deps.getPendingRecoveryState();
		if (pending.activeCaptureId) {
			new Notice("A recovery capture is already active. Opening its status.");
			await this.showRecoveryStatus();
			return;
		}
		this.recordRecoveryEvent(PRODUCT_EVENT_KIND.recoveryCaptureStart, "info", { reason: "manual" });
		try {
			const started = await this.client().startCapture("manual");
			await this.persist({ activeCaptureId: started.captureId, lastCaptureStatus: null });
			new Notice("Recovery capture queued. It will continue if Obsidian closes.", 7000);
			this.scheduleMonitor(0);
		} catch (error) {
			this.recordRecoveryEvent(PRODUCT_EVENT_KIND.recoveryCaptureComplete, "error", { reason: "manual", error: formatUnknown(error) });
			new Notice(`Recovery capture could not start: ${formatUnknown(error)}`, 8000);
		}
	}

	async showRecoveryStatus(): Promise<void> {
		try {
			const recovery = await this.client().getRecoveryStatus();
			await this.persist({ lastRecoveryStatus: recovery });
			this.captureStatusModal?.close();
			this.captureStatusModal = new RecoveryCaptureStatusModal(
				this.deps.app,
				recovery,
				recovery.activeCapture ?? this.deps.getPendingRecoveryState().lastCaptureStatus,
				() => this.cancelActiveCapture(),
				() => this.cancelActiveRestore(),
				() => this.refreshRecoveryStatusModal(),
			);
			this.captureStatusModal.open();
		} catch (error) {
			new Notice(`Could not load recovery status: ${formatUnknown(error)}`, 8000);
		}
	}

	async showSnapshotList(): Promise<void> {
		if (!this.hasRecoveryService("browse recovery points")) return;
		new Notice("Loading recovery points…");
		try {
			const snapshots: RecoverySnapshotSummary[] = [];
			let cursor: string | null = null;
			do {
				const page = await this.client().listSnapshots(cursor, 100);
				snapshots.push(...page.snapshots);
				cursor = page.nextCursor;
			} while (cursor && snapshots.length < 1_000);
			if (snapshots.length === 0) {
				new Notice("No recovery points exist yet.");
				return;
			}
			this.snapshotListModal?.close();
			this.snapshotListModal = new RecoverySnapshotListModal(
				this.deps.app,
				snapshots,
				(snapshot) => this.browseSnapshot(snapshot),
				(snapshot) => this.confirmDeleteSnapshot(snapshot),
			);
			this.snapshotListModal.open();
		} catch (error) {
			new Notice(`Could not list recovery points: ${formatUnknown(error)}`, 8000);
		}
	}

	async pruneSnapshots(): Promise<void> {
		if (!this.hasRecoveryService("clean up recovery points")) return;
		try {
			const result = await this.client().applyRetention();
			new Notice(
				`Recovery retention updated: ${result.retained} retained, ${result.removed} roots removed` +
				`${result.deferred ? `, ${result.deferred} deferred by active jobs` : ""}. ` +
				"Unreferenced objects are reclaimed only by resumable garbage collection.",
				9000,
			);
		} catch (error) {
			new Notice(`Recovery retention failed: ${formatUnknown(error)}`, 8000);
		}
	}

	async restartPendingRestore(): Promise<void> {
		const active = this.deps.getPendingRecoveryState().activeRestore;
		if (!active) {
			new Notice("There is no interrupted restore to restart.");
			return;
		}
		if (!this.deps.getRecoveryRuntime() || !this.canUseRecovery("restart the restore")) return;
		this.recordRecoveryEvent(PRODUCT_EVENT_KIND.recoveryRestoreRestarted, "info", active);
		await this.resumeRestore(active.restoreId, active.snapshotId);
	}

	private async browseSnapshot(snapshot: RecoverySnapshotSummary): Promise<void> {
		try {
			const root = await this.client().getSnapshotRoot(snapshot.snapshotId, snapshot.rootHash);
			this.browseModal?.close();
			this.browseModal = new RecoveryBrowseModal(
				this.deps.app,
				root,
				(path) => this.client().lookupPathEntry(snapshot.snapshotId, path),
				(bodyId) => this.client().lookupDeletedEntry(snapshot.snapshotId, bodyId),
				(selection) => this.startRestore(snapshot.snapshotId, selection),
			);
			this.browseModal.open();
		} catch (error) {
			new Notice(`Could not inspect recovery point: ${formatUnknown(error)}`, 8000);
		}
	}

	private async startRestore(snapshotId: string, selection: RestoreSelection): Promise<void> {
		if (!this.deps.getRecoveryRuntime() || !this.canUseRecovery("restore files")) return;
		if (this.deps.getPendingRecoveryState().activeRestore) {
			new Notice("Another restore is already active. Resume or cancel it first.", 8000);
			return;
		}
		try {
			const started = await this.client().startRestore(snapshotId, selection);
			await this.persist({ activeRestore: { restoreId: started.restoreId, snapshotId }, lastRestoreStatus: null });
			new Notice("Restore job queued. Work is checkpointed and can resume after restart.", 8000);
			await this.resumeRestore(started.restoreId, snapshotId);
		} catch (error) {
			new Notice(`Restore could not start: ${formatUnknown(error)}`, 10000);
		}
	}

	private async resumeRestore(restoreId: string, snapshotId: string): Promise<void> {
		const runtime = this.deps.getRecoveryRuntime();
		if (!runtime) {
			this.scheduleMonitor(STATUS_POLL_MS);
			return;
		}
		try {
			const status = await this.client().getRestoreStatus(restoreId);
			await this.persist({ lastRestoreStatus: status });
			if (status.state === "failed" || status.state === "cancelled") {
				await this.persist({ activeRestore: null });
				new Notice(`Restore ${status.state}${status.error ? `: ${status.error.code}` : ""}.`, 10000);
				return;
			}
			if (status.state === "complete") {
				await this.persist({ activeRestore: null });
				new Notice("Restore complete.", 8000);
				this.deps.onEditorsNeedReconcile("recovery-restore");
				return;
			}
			if (status.state !== "awaiting-results") {
				this.scheduleMonitor(this.retryDelay(status.state === "retrying" ? status.nextAttemptAt : null));
				return;
			}
			let cursor: string | null = null;
			let applied = 0;
			do {
				const page = await this.client().listRestoreItems(restoreId, cursor, RESTORE_PAGE_SIZE);
				if (page.items.length === 0) break;
				const results = await this.applyRestorePage(restoreId, snapshotId, page.items, runtime);
				const nextStatus = await this.client().reportRestoreResults(restoreId, results);
				await this.persist({ lastRestoreStatus: nextStatus });
				applied += results.length;
				cursor = page.nextCursor;
			} while (cursor && applied < 500);
			this.deps.onEditorsNeedReconcile("recovery-restore");
			this.scheduleMonitor(0);
		} catch (error) {
			this.deps.log(`Restore ${restoreId} paused: ${formatUnknown(error)}`);
			new Notice(`Restore paused: ${formatUnknown(error)}. It will retry safely.`, 10000);
			this.scheduleMonitor(STATUS_POLL_MS);
		}
	}

	private async applyRestorePage(restoreId: string, snapshotId: string, items: RestoreItem[], runtime: RecoveryRuntimePort): Promise<RestoreItemResult[]> {
		const catalog = this.deps.getAttachmentCatalog();
		const markdownReviews = new Map<string, RecoveryLiveFile | null>();
		const attachmentReviews = new Map<string, { hash: string; size: number } | null>();
		for (const item of items) {
			if (item.kind === "markdown") markdownReviews.set(item.itemId, await runtime.getLive(item.path));
			else attachmentReviews.set(item.itemId, catalog?.getAttachmentRef(item.path) ?? null);
		}
		const backupHook = new RecoveryBackupHook(this.deps.app, {
			log: (message) => this.deps.log(message),
		});
		const backup = await backupHook.backupBeforeReplacement(items.map((item) => item.path));
		if (!backup.complete) throw new Error(`restore backup is incomplete at ${backup.backupRoot}`);
		const results: RestoreItemResult[] = [];
		for (const item of items) {
			const diskReview = backup.reviews.get(item.path);
			if (!diskReview) throw new Error(`restore backup omitted review for ${item.path}`);
			if (!await backupHook.targetStillMatches(diskReview, item.path)) {
				results.push({ itemId: item.itemId, outcome: "skipped-changed" });
				continue;
			}
			try {
				if (item.kind === "markdown") {
					results.push(await this.client().applyMarkdownItem(restoreId, snapshotId, item, markdownReviews.get(item.itemId) ?? null, runtime));
				} else {
					results.push(await this.applyAttachmentItem(restoreId, item, attachmentReviews.get(item.itemId) ?? null));
				}
			} catch (error) {
				if (!(error instanceof RecoveryTerminalItemError)) throw error;
				results.push({ itemId: item.itemId, outcome: "failed", errorCode: error.errorCode });
			}
		}
		this.deps.log(`Applied restore page of ${items.length}; backup=${backup.backupRoot}`);
		return results;
	}

	private async applyAttachmentItem(restoreId: string, item: Extract<RestoreItem, { kind: "attachment" }>, liveAtReview: { hash: string; size: number } | null): Promise<RestoreItemResult> {
		const catalog = this.deps.getAttachmentCatalog();
		const blobSync = this.deps.getBlobSync();
		if (!catalog || !blobSync) throw new Error("attachment recovery runtime is unavailable");
		await this.client().downloadRestoreItem(restoreId, item);
		const current = catalog.getAttachmentRef(item.path) ?? null;
		const unchanged = current === null
			? liveAtReview === null
			: liveAtReview !== null && current.hash === liveAtReview.hash && current.size === liveAtReview.size;
		if (!unchanged && !(current?.hash === item.contentHash && current.size === item.size)) {
			return { itemId: item.itemId, outcome: "skipped-changed" };
		}
		await catalog.setAttachmentRef(item.path, item.contentHash, item.size, item.mime ?? "application/octet-stream");
		await blobSync.forceDownloads([item.path]);
		return { itemId: item.itemId, outcome: "restored" };
	}

	private async cancelActiveCapture(): Promise<void> {
		const captureId = this.deps.getPendingRecoveryState().activeCaptureId;
		if (!captureId) return;
		try {
			const status = await this.client().cancelCapture(captureId);
			await this.persist({ activeCaptureId: isRecoveryTerminal(status.state) ? null : captureId, lastCaptureStatus: status });
			this.captureStatusModal?.setCaptureStatus(status);
			new Notice(status.state === "cancelled" ? "Recovery capture cancelled." : `Capture is ${status.state}.`);
		} catch (error) {
			new Notice(`Could not cancel capture: ${formatUnknown(error)}`, 8000);
		}
	}

	private async cancelActiveRestore(): Promise<void> {
		const active = this.deps.getPendingRecoveryState().activeRestore;
		if (!active) return;
		try {
			const status = await this.client().cancelRestore(active.restoreId);
			await this.persist({
				activeRestore: isRecoveryTerminal(status.state) ? null : active,
				lastRestoreStatus: status,
			});
			await this.refreshRecoveryStatusModal();
			new Notice(status.state === "cancelled" ? "Recovery restore cancelled." : `Restore is ${status.state}.`);
		} catch (error) {
			new Notice(`Could not cancel restore: ${formatUnknown(error)}`, 8000);
		}
	}

	private async refreshRecoveryStatusModal(): Promise<void> {
		const recovery = await this.client().getRecoveryStatus();
		await this.persist({ lastRecoveryStatus: recovery });
		this.captureStatusModal?.setRecoveryStatus(recovery);
		const captureId = this.deps.getPendingRecoveryState().activeCaptureId;
		if (captureId) {
			const capture = await this.client().getCaptureStatus(captureId);
			await this.persist({ lastCaptureStatus: capture, activeCaptureId: isRecoveryTerminal(capture.state) ? null : captureId });
			this.captureStatusModal?.setCaptureStatus(capture);
		}
	}

	private scheduleMonitor(delayMs: number): void {
		if (this.monitorTimer !== null) window.clearTimeout(this.monitorTimer);
		this.monitorTimer = window.setTimeout(() => {
			this.monitorTimer = null;
			void this.monitorPending();
		}, delayMs);
	}

	private async monitorPending(): Promise<void> {
		if (this.monitoring) return;
		this.monitoring = true;
		try {
			const pending = this.deps.getPendingRecoveryState();
			let nextDelay: number | null = null;
			if (pending.activeCaptureId) {
				try {
					const status = await this.client().getCaptureStatus(pending.activeCaptureId);
					await this.persist({
						lastCaptureStatus: status,
						activeCaptureId: isRecoveryTerminal(status.state) ? null : pending.activeCaptureId,
					});
					this.captureStatusModal?.setCaptureStatus(status);
					if (status.state === "complete" || status.state === "complete_with_gaps") {
						this.recordRecoveryEvent(PRODUCT_EVENT_KIND.recoveryCaptureComplete, "info", {
							captureId: status.captureId,
							snapshotId: status.snapshotId,
							state: status.state,
						});
						new Notice(
							status.state === "complete_with_gaps"
								? "Recovery point captured with unavailable items. Open recovery status for details."
								: status.snapshotId ? "Recovery point captured." : "Recovery capture completed.",
							10000,
						);
					} else if (status.state === "failed" || status.state === "cancelled") {
						this.recordRecoveryEvent(
							PRODUCT_EVENT_KIND.recoveryCaptureComplete,
							status.state === "failed" ? "error" : "info",
							{ captureId: status.captureId, state: status.state, error: status.error },
						);
						new Notice(`Recovery capture ${status.state}${status.error ? `: ${status.error.code}` : ""}.`, 10000);
					} else {
						nextDelay = this.retryDelay(status.nextAttemptAt);
					}
				} catch (error) {
					this.deps.log(`Capture status resume failed: ${formatUnknown(error)}`);
					nextDelay = STATUS_POLL_MS;
				}
			}
			const activeRestore = this.deps.getPendingRecoveryState().activeRestore;
			if (activeRestore) {
				await this.resumeRestore(activeRestore.restoreId, activeRestore.snapshotId);
				nextDelay = STATUS_POLL_MS;
			}
			try {
				const recovery = await this.client().getRecoveryStatus();
				await this.persist({ lastRecoveryStatus: recovery });
				this.captureStatusModal?.setRecoveryStatus(recovery);
			} catch (error) {
				this.deps.log(`Recovery readiness refresh failed: ${formatUnknown(error)}`);
			}
			if (
				nextDelay !== null
				&& (this.deps.getPendingRecoveryState().activeCaptureId || this.deps.getPendingRecoveryState().activeRestore)
			) {
				this.scheduleMonitor(nextDelay);
			}
		} finally {
			this.monitoring = false;
		}
	}

	private retryDelay(nextAttemptAt: number | null): number {
		return nextAttemptAt === null ? STATUS_POLL_MS : Math.max(250, Math.min(60_000, nextAttemptAt - Date.now()));
	}

	private async persist(update: Partial<PendingRecoveryState>): Promise<void> {
		await this.deps.persistPendingRecoveryState({ ...this.deps.getPendingRecoveryState(), ...update });
	}

	private confirmDeleteSnapshot(snapshot: RecoverySnapshotSummary): void {
		new ConfirmModal(
			this.deps.app,
			"Delete recovery point?",
			"This removes the retained v2 root. Current files and other roots remain. Unreferenced content is reclaimed later by recovery garbage collection.",
			async () => {
				try {
					await this.client().deleteSnapshot(snapshot.snapshotId);
					new Notice("Recovery point deleted. Content cleanup remains resumable in the background.", 8000);
				} catch (error) {
					new Notice(`Recovery point deletion failed: ${formatUnknown(error)}`, 8000);
				}
			},
		).open();
	}

	private client(): RecoveryClient {
		return new RecoveryClient(this.deps.getSettings(), this.deps.getTraceHttpContext());
	}

	private hasRecoveryService(action: string): boolean {
		if (this.deps.getServerSupportsSnapshots()) return true;
		new Notice(`Cannot ${action}: recovery storage or the recovery job service is unavailable.`);
		return false;
	}

	private canUseRecovery(action: string): boolean {
		if (!this.hasRecoveryService(action)) return false;
		if (!this.deps.getVaultSync()?.connected) {
			new Notice(`Cannot ${action}: sync is not connected.`);
			return false;
		}
		return true;
	}

	private recordRecoveryEvent(kind: ProductFlightEventInput["kind"], severity: ProductFlightEventInput["severity"], data: Record<string, unknown>): void {
		this.deps.recordFlightEvent?.({
			kind,
			severity,
			priority: severity === "error" ? "critical" : "important",
			scope: "vault",
			source: "vaultSync",
			layer: "recovery",
			data,
		});
	}
}
