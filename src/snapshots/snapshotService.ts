import { App, Notice, TFile, normalizePath } from "obsidian";
import { BlobSyncManager } from "../sync/blobSync";
import { DiskMirror } from "../sync/diskMirror";
import {
	diffSnapshot,
	downloadSnapshot,
	listSnapshots as fetchSnapshotList,
	requestDailySnapshot,
	requestSnapshotNow,
	restoreFromSnapshot,
	type SnapshotIndex,
} from "../sync/snapshotClient";
import { VaultSync } from "../sync/vaultSync";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext } from "../debug/trace";
import { formatUnknown } from "../utils/format";
import { SnapshotDiffModal, SnapshotListModal } from "./snapshotModals";

interface SnapshotServiceDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getVaultSync(): VaultSync | null;
	getDiskMirror(): DiskMirror | null;
	getBlobSync(): BlobSyncManager | null;
	getServerSupportsSnapshots(): boolean;
	log(message: string): void;
	onEditorsNeedReconcile(reason: string): void;
}

export class SnapshotService {
	constructor(private readonly deps: SnapshotServiceDeps) {}

	/**
	 * Request the daily snapshot from the server.
	 * Silent noop if R2 isn't configured or snapshot already taken today.
	 */
	async triggerDailySnapshot(): Promise<void> {
		if (!this.deps.getServerSupportsSnapshots()) {
			return;
		}

		const settings = this.deps.getSettings();
		try {
			const result = await requestDailySnapshot(
				settings,
				settings.deviceName,
				this.deps.getTraceHttpContext(),
			);
			if (result.status === "created") {
				this.deps.log(`Daily snapshot created: ${result.snapshotId}`);
			} else if (result.status === "noop") {
				this.deps.log("Daily snapshot: already taken today");
			} else {
				this.deps.log(`Daily snapshot: ${result.reason ?? "unavailable"}`);
			}
		} catch (err) {
			// Don't spam the user; snapshot failure is non-critical.
			console.warn("[yaos] Daily snapshot failed:", err);
		}
	}

	async takeSnapshotNow(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			new Notice("Snapshots are unavailable until object storage is configured on the server.");
			return;
		}
		if (!vaultSync.connected) {
			new Notice("Not connected to server — cannot create snapshot.");
			return;
		}

		const settings = this.deps.getSettings();
		new Notice("Creating snapshot...");
		try {
			const result = await requestSnapshotNow(
				settings,
				settings.deviceName,
				this.deps.getTraceHttpContext(),
			);
			if (result.status === "created" && result.index) {
				new Notice(
					`Snapshot created: ${result.index.markdownFileCount} notes, ` +
					`${result.index.blobFileCount} attachments ` +
					`(${Math.round(result.index.crdtSizeBytes / 1024)} KB)`,
				);
			} else if (result.status === "unavailable") {
				new Notice(`Snapshot unavailable: ${result.reason ?? "R2 not configured"}`);
			} else {
				new Notice("Snapshot created.");
			}
		} catch (err) {
			console.error("[yaos] Snapshot failed:", err);
			new Notice(`Snapshot failed: ${formatUnknown(err)}`);
		}
	}

	/**
	 * Show a list of available snapshots and let the user pick one to diff/restore.
	 */
	async showSnapshotList(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}
		if (!this.deps.getServerSupportsSnapshots()) {
			new Notice("Snapshots are unavailable until object storage is configured on the server.");
			return;
		}
		if (!vaultSync.connected) {
			new Notice("Not connected to server — cannot browse snapshots.");
			return;
		}

		new Notice("Loading snapshots...");

		try {
			const snapshots = await fetchSnapshotList(
				this.deps.getSettings(),
				this.deps.getTraceHttpContext(),
			);

			if (snapshots.length === 0) {
				new Notice("No snapshots found. Take a snapshot first.");
				return;
			}

			new SnapshotListModal(this.deps.app, snapshots, async (selected) => {
				await this.showSnapshotDiff(selected);
			}).open();
		} catch (err) {
			console.error("[yaos] Failed to list snapshots:", err);
			new Notice(`Failed to list snapshots: ${formatUnknown(err)}`);
		}
	}

	/**
	 * Download a snapshot, compute diff against current CRDT, and show the restore UI.
	 */
	private async showSnapshotDiff(snapshot: SnapshotIndex): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;

		new Notice("Downloading snapshot...");

		try {
			const snapshotDoc = await downloadSnapshot(
				this.deps.getSettings(),
				snapshot,
				this.deps.getTraceHttpContext(),
			);
			const diff = diffSnapshot(snapshotDoc, vaultSync.ydoc);

			let destroyed = false;
			const cleanup = () => {
				if (!destroyed) {
					destroyed = true;
					snapshotDoc.destroy();
				}
			};

			new SnapshotDiffModal(
				this.deps.app,
				snapshot,
				diff,
				async (markdownPaths, blobPaths) => {
					const liveVaultSync = this.deps.getVaultSync();
					if (!liveVaultSync) return;

					const backupDir = normalizePath(
						`${this.deps.app.vault.configDir}/plugins/yaos/restore-backups/${new Date().toISOString().replace(/[:.]/g, "-")}`,
					);
					let backedUp = 0;
					for (const path of markdownPaths) {
						try {
							const file = this.deps.app.vault.getAbstractFileByPath(path);
							if (file instanceof TFile) {
								const content = await this.deps.app.vault.read(file);
								const backupPath = `${backupDir}/${path}`;
								const parentDir = backupPath.substring(0, backupPath.lastIndexOf("/"));
								if (parentDir && !this.deps.app.vault.getAbstractFileByPath(parentDir)) {
									await this.deps.app.vault.createFolder(parentDir);
								}
								await this.deps.app.vault.create(backupPath, content);
								backedUp++;
							}
						} catch (err) {
							// Non-fatal: file might not exist on disk (undelete case).
							this.deps.log(`Backup skipped for "${path}": ${formatUnknown(err)}`);
						}
					}
					if (backedUp > 0) {
						this.deps.log(`Pre-restore backup: ${backedUp} files saved to ${backupDir}`);
					}

					const result = restoreFromSnapshot(snapshotDoc, liveVaultSync.ydoc, {
						markdownPaths,
						blobPaths,
						device: this.deps.getSettings().deviceName,
					});

					for (const path of markdownPaths) {
						await this.deps.getDiskMirror()?.flushWrite(path, true);
					}

					if (blobPaths.length > 0) {
						const queued = this.deps.getBlobSync()?.prioritizeDownloads(blobPaths) ?? 0;
						if (queued > 0) {
							this.deps.log(`Restore: queued ${queued} blob downloads`);
						}
					}

					this.deps.onEditorsNeedReconcile("snapshot-restore");

					const parts: string[] = [];
					if (result.markdownRestored > 0) parts.push(`${result.markdownRestored} files restored`);
					if (result.markdownUndeleted > 0) parts.push(`${result.markdownUndeleted} files undeleted`);
					if (result.blobsRestored > 0) parts.push(`${result.blobsRestored} attachments restored`);
					if (backedUp > 0) parts.push(`backup in ${backupDir}`);

					const msg = parts.length > 0
						? `Restore complete: ${parts.join(", ")}.`
						: "No changes were applied.";
					new Notice(msg, 8000);
					this.deps.log(`Restore from snapshot ${snapshot.snapshotId}: ${msg}`);

					cleanup();
				},
				cleanup,
			).open();
		} catch (err) {
			console.error("[yaos] Snapshot diff failed:", err);
			new Notice(`Failed to load snapshot: ${formatUnknown(err)}`);
		}
	}
}
